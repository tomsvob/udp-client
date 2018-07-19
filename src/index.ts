import * as dgram from "dgram";
import * as fs from "fs";
import * as promiseFinally from "promise.prototype.finally";
import * as assert from 'assert';

promiseFinally.shim();

const DOWNLOAD_IMAGE_PATH = 'foto.png';
const TIMEOUT = 100;

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
        return new Packet(this.computeBuffer(connectionIdentifier, sequentialNumber, ackNumber, flag, data));
    }

    private static computeBuffer(connectionIdentifier: number, sequentialNumber: number, ackNumber: number, flag: number, data: Buffer): Buffer {
        const buffer = Buffer.allocUnsafe(this.getPacketSize(data));
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
            this.connectionIdentifier.toString(16)}\t${
            this.sequentialNumber}\t${
            this.ackNumber}\t${
            this.flag.toString(16)}\t${
            this.data.length}`;
    }
}

abstract class Connection {
    private socket: dgram.Socket;
    protected static PART_SIZE: number = 0xff;
    protected static WINDOW_SIZE: number = 8;
    protected connectionId: number = 0;
    private socketMessageListenerBound = this.socketMessageListener.bind(this);
    private timeoutId: number = 0;
    private finTimeoutId: number = 0;

    protected constructor(
        private server: NetAddress,
        protected COMMAND_TYPE: ConnectionMode,
        private resolve: () => void, // success cb
        private reject: (error: string) => void, // error cb
    ) {
        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', this.socketMessageListenerBound);
        this.socket.on('listening', this.sendSynPacket.bind(this)); // initiate connection when ready
        this.socket.bind();
    }

    private socketMessageListener(msg: Buffer) {
        const packet = new Packet(msg);
        console.log('RECV', packet.toString());
        this.processPacket(packet);
    }

    private sendPacket(packet: Packet) {
        return new Promise((res) => {
            clearTimeout(this.timeoutId);
            this.timeoutId = setTimeout(this.timeoutHandler.bind(this), TIMEOUT);
            const buffer = packet.buffer;
            this.socket.send(buffer, 0, buffer.length, this.server.port, this.server.host, (err) => {
                assert(!err, 'sending packet on closed connection');
                console.log('SENT', packet.toString());
                res();
            });
        });
    }

    private createDataPacket(seq: number, ack: number, flag: ConnectionFlag, data: Buffer) {
        return Packet.createFromParams(this.connectionId, seq, ack, flag, data)
    }

    private createPacket(seq: number, ack: number, flag: ConnectionFlag) {
        return this.createDataPacket(seq, ack, flag, Buffer.allocUnsafe(0));
    }

    protected sendSynPacket() {
        const buff = Buffer.alloc(1);
        buff.writeUInt8(this.COMMAND_TYPE, 0);
        this.sendPacket(this.createDataPacket(0, 0, ConnectionFlag.SYN, buff));
    }

    private sendRstPacket() {
        this.sendPacket(this.createPacket(0, 0, ConnectionFlag.RST));
    }

    private sendFinPacket(seq: number) {
        return this.sendPacket(this.createPacket(0, seq, ConnectionFlag.FIN));
    }

    protected sendAckPacket(ack: number) {
        this.sendPacket(this.createPacket(0, ack, ConnectionFlag.DATA));
    }

    private processPacket(packet: Packet) {
        if (!this.connectionId && packet.flag !== ConnectionFlag.SYN) {
            return; // waiting for SYN
        } else if (!this.connectionId || this.connectionId === packet.connectionIdentifier) {
            // current connection
            if (packet.isValid(this.COMMAND_TYPE, this.connectionId)) {
                switch (packet.flag) {
                    case ConnectionFlag.SYN:
                        this.connectionId = packet.connectionIdentifier;
                        console.log('accepted connection', this.connectionId);
                        break;
                    case ConnectionFlag.RST:
                        this.forceCloseConnection('received RST flag');
                        break;
                    case ConnectionFlag.FIN:
                        this.sendFinPacket(packet.sequentialNumber);
                        clearTimeout(this.finTimeoutId);
                        this.finTimeoutId = setTimeout(this.successCloseConnection.bind(this), TIMEOUT * 10);
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
        clearTimeout(this.timeoutId);
        this.socket.close();
    }

    protected abstract processDataPacket(packet: Packet): void;

    protected abstract timeoutHandler(): void;
}

class DownloadConnection extends Connection {
    private lastSequentialNumber: number = 0;
    private window: Array<Buffer> = [];

    constructor(
        private passData: (data: Buffer) => void,
        server: NetAddress,
        COMMAND_TYPE: ConnectionMode,
        resolve: () => void, // success cb
        reject: (error: string) => void, // error cb
    ) {
        super(server, COMMAND_TYPE, resolve, reject);
    }

    processDataPacket(packet: Packet): void {
        const packetSeq = packet.sequentialNumber;
        const windowPacketIndex = DownloadConnection.getPacketWindowIndex(packetSeq, this.lastSequentialNumber);
        console.log('index', windowPacketIndex, this.lastSequentialNumber, packetSeq);

        if (windowPacketIndex < 0 || this.window[windowPacketIndex] || windowPacketIndex >= Connection.WINDOW_SIZE) {
            console.log('redundant packet - ignoring', packetSeq);
        } else {
            this.window[windowPacketIndex] = packet.data;
            if (windowPacketIndex === 0) {
                this.consumeWindow();
            } else {
                console.log('received packet - storing', packetSeq);
            }
        }

        this.sendAckPacket(this.lastSequentialNumber);
    }

    private consumeWindow() {
        if (this.window[0]) {
            console.log('consuming buffer - ', this.lastSequentialNumber);
            const nextData = <Buffer> this.window.shift();
            this.passData(nextData);
            const sum = this.lastSequentialNumber + nextData.length;
            this.lastSequentialNumber = sum > 0xffff ? sum - 0x10000 : sum;
            this.consumeWindow();
        }

    }

    protected timeoutHandler(): void {
        if (!this.connectionId) {
            console.log('timeout', this.connectionId);
            this.sendSynPacket();
        }
    }

    private static getPacketWindowIndex(packetSeq: number, mySeq: number) {
        return Math.ceil(DownloadConnection.fixOverflow(packetSeq - mySeq) / Connection.PART_SIZE);
    }

    private static fixOverflow(num: number) {
        return num < 0 ? num + 0xffff : num;
    }

    public static asPromise(
        passData: (data: Buffer) => void,
        server: NetAddress,
        COMMAND_TYPE: ConnectionMode,
    ): Promise<void> {
        return new Promise((res: () => void, rej: (error: string) => void) => {
            new DownloadConnection(passData, server, COMMAND_TYPE, res, rej);
        })
    }

    public static testStatic() {
        assert(DownloadConnection.fixOverflow(1) === 1, 'fixOverflow');
        assert(DownloadConnection.fixOverflow(0) === 0, 'fixOverflow');
        assert(DownloadConnection.fixOverflow(-1) === 0xffff - 1, 'fixOverflow');
        assert(DownloadConnection.fixOverflow(-0xff) === 0xff00, 'fixOverflow');
        assert(DownloadConnection.getPacketWindowIndex(0, 0) === 0, 'gePacketWindowIndex');
        assert(DownloadConnection.getPacketWindowIndex(0xffff, 0xffff) === 0, 'gePacketWindowIndex');
        assert(DownloadConnection.getPacketWindowIndex(0xffff, 0xff00) === 1, 'gePacketWindowIndex');
    }
}

DownloadConnection.testStatic();


class UploadConnection extends Connection {

    constructor(
        private getData: (offset: number, size: number) => Promise<Buffer>,
        server: NetAddress,
        COMMAND_TYPE: ConnectionMode,
        resolve: () => void, // success cb
        reject: (error: string) => void, // error cb
    ) {
        super(server, COMMAND_TYPE, resolve, reject);
    }

    protected timeoutHandler(): void {
        if (!this.connectionId) {
            this.sendSynPacket();
        }
    }

    processDataPacket(packet: Packet): void {
        console.warn('stub'); // TODO: implement
    }

    public static asPromise(
        getData: (offset: number, size: number) => Promise<Buffer>,
        server: NetAddress,
        COMMAND_TYPE: ConnectionMode,
    ): Promise<Buffer> {
        return new Promise<Buffer>((res: () => void, rej: (error: string) => void) => {
            new UploadConnection(getData, server, COMMAND_TYPE, res, rej);
        });
    }
}

class Client {

    constructor(private server: NetAddress) {
    }

    public downloadImage() {
        Client.getFileDescriptor(DOWNLOAD_IMAGE_PATH, 'w')
            .then((fd) => DownloadConnection.asPromise(
                (data: Buffer) => Client.writeFilePart(fd, data),
                this.server, ConnectionMode.DownloadImage)
                .finally(() => Client.closeFileDescriptor(fd))
            )
            .then(() => console.log(`image is stored in file: ${DOWNLOAD_IMAGE_PATH}`))
            .catch(console.error);
    }

    public uploadFirmware(filePath: string) {
        Client.getFileDescriptor(filePath, 'r')
            .then((fd: number): Promise<Buffer> =>
                UploadConnection.asPromise(
                    (offset: number, size: number) => Client.readFile(fd, offset, size),
                    this.server, ConnectionMode.SendFirmware)
                    .finally(() => Client.closeFileDescriptor(fd)))
            .then((message: Buffer) => {
                console.log('done');
            })
            .catch((err: string) => console.error(err));
    }

    private static getFileDescriptor(path: string, flags: string): Promise<number> {
        return new Promise<number>((res, rej) => {
            fs.open(path, flags, (status: NodeJS.ErrnoException, fd: number) => {
                if (status) rej(`file cannot be accessed: ${path}`);
                else res(fd);
            });
        });
    }

    private static closeFileDescriptor(fd: number) {
        fs.close(fd, (err) => {
            assert(!err, err && err.message);
        });
    }

    private static readFile(fd: number, offset: number, size: number): Promise<Buffer> {
        const buffer = Buffer.allocUnsafe(size);
        return new Promise((res) => {
            fs.read(fd, buffer, 0, size, offset, (err: NodeJS.ErrnoException, bytesRead, buffer) => {
                assert(!err, err && err.message);
                res(buffer.slice(0, bytesRead));
            })
        });
    }

    private static writeFilePart(fd: number, buffer: Buffer) {
        fs.write(fd, buffer, (err: NodeJS.ErrnoException) => {
            assert(!err, err && err.message);
        });
    }

    private static writeFile(path: string, buffer: Buffer): Promise<any> {
        return new Promise((res, rej) =>
            this.getFileDescriptor(path, 'w')
                .then((fd) => {
                    fs.write(fd, buffer, null, null, null, (err: NodeJS.ErrnoException) => {
                        if (err) {
                            rej(`could not write content to file: ${path}`);
                        } else {
                            res()
                        }
                    });
                }));
    }
}

// execute section
const client = new Client({host: getHost(), port: 4000});
switch (chooseMode()) {
    case AppMode.DownloadImage:
        console.log('download image');
        client.downloadImage();
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