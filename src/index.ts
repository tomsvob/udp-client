import * as dgram from "dgram";

const fs = require('fs');
// const dgram = require('dgram');

const DOWNLOAD_IMAGE_PATH = 'foto.png';

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
    RST = 0x1,
    FIN = 0x2,
    SYN = 0x4,
}

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
    private readonly buffer: Buffer;

    constructor(
        private connectionIdentifier: number,
        private sequentialNumber: number,
        private ackNumber: number,
        private flag: ConnectionFlag,
        private data: Buffer) {
        this.buffer = this.computeBuffer();
    }

    private computeBuffer(): Buffer {
        const buffer = Buffer.alloc(this.getPacketSize());
        buffer.writeUInt32BE(this.connectionIdentifier, Packet.CONNECTION_IDENTIFIER_OFFSET);
        buffer.writeUInt16BE(this.sequentialNumber, Packet.SEQUENTIAL_NUMBER_OFFSET);
        buffer.writeUInt16BE(this.ackNumber, Packet.ACK_NUMBER_OFFSET);
        buffer.writeUInt8(this.flag, Packet.FLAG_OFFSET);
        buffer.fill(this.data, Packet.DATA_OFFSET, this.getPacketSize());
        return buffer;
    }

    public getBuffer(): Buffer {
        return this.buffer;
    }

    private getPacketSize() {
        return Packet.CONNECTION_IDENTIFIER_SIZE +
            Packet.SEQUENTIAL_NUMBER_SIZE +
            Packet.ACK_NUMBER_SIZE +
            Packet.FLAG_SIZE +
            this.data.length;
    }
}

class Connection {
    private socket: dgram.Socket;
    protected PART_SIZE: number = 255;
    protected WINDOW_SIZE: number = 8;
    protected window: Array<Buffer> = [];

    constructor(
        private HOST: string,
        private PORT: number,
        protected COMMAND_TYPE: number,
    ) {
        this.socket = dgram.createSocket('udp4');
        this.socket.bind(4000);
        this.socket.on('message', (msg) => {
            console.log(msg);
        })

    }

    protected sendSynPacket(): Promise<void> {
        const packet = new Packet(0, 0, 0, ConnectionFlag.SYN, this.getCommandBuffer());
        return this.sendPacket(packet);
    }

    private getCommandBuffer(): Buffer {
        const buff = Buffer.alloc(1);
        buff.writeUInt8(this.COMMAND_TYPE, 0);
        return buff;
    }

    private sendPacket(packet: Packet): Promise<void> {
        const buffer = packet.getBuffer();
        return new Promise((res, rej) => {
            this.socket.send(buffer, 0, buffer.length, this.PORT, this.HOST, (err) => {
                console.log(this.PORT, this.HOST, buffer);
                if (err) {
                    throw 'sending packet on closed connection';
                } else {
                    res();
                }
            });
        });
    }

    protected closeConnection() {
        this.socket.close();
    }

}

class DownloadConnection extends Connection {
    constructor(host: string, port: number) {
        super(host, port, ConnectionMode.DownloadImage);
    }

    public downloadImage(): Promise<Buffer> {
        return this.sendSynPacket().then(() => {
            this.closeConnection();
            return Buffer.from('fake');
        });
    }
}

class Client {

    constructor(private HOST: string, private PORT: number) {
    }

    public downloadImage() {
        const connection = new DownloadConnection(this.HOST, this.PORT);
        connection.downloadImage()
            .then((img: Buffer) => {
                console.log('image downloaded');
                Client.writeFile(DOWNLOAD_IMAGE_PATH, img)
                    .then(() => console.log(`image is stored in file: ${DOWNLOAD_IMAGE_PATH}`))
                    .catch(console.error);
            })
            .catch(console.error);
    }

    public uploadFirmware(filePath: string) {
        Client.getFileDescriptor(filePath, 'r')
            .then((fd) => {
                const connection = new UploadConnection(this.HOST, this.PORT, ConnectionMode.SendFirmware);
                return connection.sendToServer(fd);
            })
            .catch((err) => console.error(err));
    }

    private static getFileDescriptor(path: string, flags: string): Promise<number> {
        return new Promise<number>((res, rej) => {
            fs.open(path, flags, (status: NodeJS.ErrnoException, fd: number) => {
                if (status) rej(`file cannot be accessed: ${path}`);
                else res(fd);
            });
        });
    }

    private static writeFile(path: string, buffer: Buffer): Promise<any> {
        return new Promise((res, rej) => this.getFileDescriptor(path, 'w').then((fd) => {
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

class UploadConnection extends Connection {
    private nextPartIndex: number = 0;
    private eof: boolean = false;

    public sendToServer(fd: number) {
        console.warn('stub');
        // TODO: send fd content to server
    }

    private fillWindow(fd: number) {
        if (this.window.length < this.WINDOW_SIZE && !this.eof) {
            const buffer = new Buffer(this.PART_SIZE);
            this.window.push(buffer);
            fs.read(fd, buffer, 0, this.PART_SIZE, null,
                (err: NodeJS.ErrnoException, bytes: number) => {

                });
        }
    }

    private addChunkToWindow() {

    }

    sendFile() {

    }
}

// execute section

const client = new Client(getHost(), 4000);
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
        throw 'invalid arguments';
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